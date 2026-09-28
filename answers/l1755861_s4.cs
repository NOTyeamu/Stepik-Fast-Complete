using System;

class Program
{
    static void Main()
    {
        int hour = int.Parse(Console.ReadLine());
        
        if (hour >= 6 && hour <= 11)
        {
            Console.WriteLine("Утро");
        }
        else if (hour >= 12 && hour <= 17)
        {
            Console.WriteLine("День");
        }
        else if (hour >= 18 && hour <= 22)
        {
            Console.WriteLine("Вечер");
        }
        else if (hour == 23 || (hour >= 0 && hour <= 5))
        {
            Console.WriteLine("Ночь");
        }
        else
        {
            Console.WriteLine("Неверный час");
        }
    }
}