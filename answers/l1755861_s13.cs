using System;

class Program
{
    static void Main()
    {
       string currency = Console.ReadLine();
        
        switch (currency)
        {
            case "USD":
                Console.WriteLine("США");
                break;
            case "EUR":
                Console.WriteLine("Австрия");
                break;
            case "CNY":
                Console.WriteLine("Китай");
                break;
            case "KZT":
                Console.WriteLine("Казахстан");
                break;
        }
    }
}