using System;

class Program
{
    static void Main()
    {
        int number = int.Parse(Console.ReadLine());
        if (number % 5 == 0)
        {
            Console.WriteLine("Кратно 5");
        }
        else
        {
            Console.WriteLine("Не кратно 5");
        }
    }
}