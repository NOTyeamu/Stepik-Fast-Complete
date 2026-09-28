using System;

class Program
{
    static void Main()
    {
        int count = 0;
        
        while (true)
        {
            string input = Console.ReadLine();
            
            if (input == ".")
            {
                break;
            }
            
            count++;
        }
        
        Console.WriteLine($"Вы ввели {count} символа до точки.");
    }
}